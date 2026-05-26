---
id: RFC-0017
title: In-Soul Variant Pattern
status: Draft
lifecycle: Ready for Review
author: Morgan Hirtle
created: 2026-05-04
updated: 2026-05-18
targetSpecVersion: v1alpha1
requires:
  - RFC-0009
  - RFC-0024
  - RFC-0025
  - RFC-0029
  - RFC-0035
requiresDocs: []
---

# RFC-0017: In-Soul Variant Pattern

**Document type:** Normative
**Status:** Ready for Review v0.3 — operator OQ walkthrough complete 2026-05-18; all 8 §10 OQs resolved with full rubric (problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument). **Cross-cutting framing:** every operator-impacting variant lifecycle event (count thresholds, deprecation transitions, Engineering substrate-cost review, cardinality activation requests) **routes through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md)** — pipeline never halts on variant-substrate edge cases. §10.1 codifies per-Soul / per-org config schema. Practitioner-validation gates in §11 remain unresolved pending InternalAdopter four-soul implementation pass. Implementation broken into 5 phase tasks (AISDLC-352..356).
**Lifecycle:** Ready for Review
**Created:** 2026-05-04
**Updated:** 2026-05-18
**Authors:** Morgan Hirtle (Design Authority, InternalAdopter)
**Engineering pass:** Dominique Legault, Claude Opus 4.7 (orchestrator), 2026-05-04 — fleshed §3-§13 from Mo's v0.1 stub.
**OQ walkthrough:** Dominique Legault (Operator), 2026-05-18 — full-rubric resolution of all 8 §10 OQs.
**Requires:** RFC-0009 (Tessellated Design Intent Documents), RFC-0024 (Emergent Capture — catalog substrate), RFC-0025 (Framework Quality Monitoring — over-blocking audit), RFC-0029 (Product Pillar Architectural Vision — pillar model + Engineering/Design ownership), RFC-0035 (Decision Catalog — G0 non-blocking routing)

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Morgan Hirtle | Chief of Design / Design Authority | ✍️ Authored v0.1 stub | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ✏️ Engineering pass on v0.2 (pending Design editorial) | 2026-05-04 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Signed v0.2 (PPA-composability scope only; full v1.0+ pending Mo's editorial) | 2026-05-04 |

### Product Authority review (PPA-composability scope only)

This RFC is properly Mo's Design-Authority territory; the Product Authority lens is restricted to how Variants compose with PPA scoring.

**PPA composition observations**:

- **SA1 implication**: Variant-level `targetAudience.segments` + `audienceCharacteristics` feed SA1 (Problem Resonance) when work items target a specific variant. PPA v1.1 §5 already specifies variant scoring inheriting parent-shard SA1; v0.2's `targetedVariants` field on work items operationalizes this. Approved.
- **SA2 implication**: Variant `designOverrides` (voice, palette, density) are Design-Authority specializations; SA2 (Vibe Coherence) consumes them per the per-variant scoring path. No Product-side concern; Mo's editorial applies.
- **Compliance tightening invariant**: `complianceFloor: inherit` enforced at type level (per RFC-0028 substrate enforcement pattern) is the right architectural answer — child variants cannot loosen parent compliance regimes. Strong endorse.
- **Demand cluster routing**: when RFC-0030 (Signal Ingestion Pipeline) lands, demand clusters tagged with variant-specific segments should route through the variant's SA1, not the soul's. Cross-reference recommended once 0030 lands.

**Co-review recognition** per Mo's RFC-0009 v3.4 C2 condition: variants reach into `product.targetAudience` + `product.problemResonance` territory; Product co-review on `targetAudience.segments` declarations is appropriate. Not a veto; recognition that audience definition is co-authorship.

Endorsement is contingent on the v1.0+ normative spec preserving parent-soul tightening-only inheritance for compliance regimes. Variants MUST NOT loosen.

Position grounded in RFC-0029 Principle 1 (three-axis basis) + RFC-0009 §5.1 (per-soul triad specialization, tightening-only).

---

## 1. Summary

A **Variant** is a soul-scoped sub-theme within a Soul DID (RFC-0009 §2): a named configuration that carries distinct visual identity specializations and audience targeting while inheriting the parent Soul DID's foundational triad (E × P × D) and compliance regime.

This RFC defines the **In-Soul Variant Pattern** — how variants are declared on a Soul DID, how they inherit from their parent, how the admission composite (RFC-0008 / RFC-0005) scores work items that target a specific variant rather than the full soul, and where the boundary lies between "this is a variant" and "this is a separate soul."

The pattern is **configuration-based, not flow-based**. Flow-based sub-divisions (sequences of states + transitions) are RFC-0018's concern; this RFC handles the static configuration overlay.

**Practitioner validation source:** InternalAdopter's four-product suite (ProductA, ProductB, ProductC, ProductD). Each product is a distinct soul on shared substrate. Within each product, audience-specific variants emerge — e.g., ProductA has variants for small-utility-municipality vs. large-municipality vs. county-level deployments — each with distinct visual specializations and audience profiles, but all sharing the soul's WCAG 2.1 AA compliance floor and shared design system tokens.

## 2. Motivation

Today, the Soul DID model (RFC-0009) gives a single design intent surface per product face. This is correct for cases where a product has one cohesive identity. But practitioners report:

- A product targets multiple audience segments with distinct visual specializations (e.g., small-utility vs. enterprise) that share the same compliance regime + design system foundation
- Forcing each audience-segment to be its own Soul DID creates platform-level fragmentation: the substrate doesn't actually differ; only the visual + audience specialization does
- Forcing them to share one Soul DID collapses the per-segment design intent into platform-aggregate scoring (the same observed failure mode as multi-product platforms in RFC-0009 §3, applied one scope down)

Specifically observed: **a Soul DID's `design.imperatives` field feeds Sα₂ Vibe Coherence scoring at soul scope. When a soul has multiple audience-specific variants, soul-aggregate Sα₂ scoring produces the same misallocation pattern RFC-0009 documented at the platform↔soul boundary** — work that's variant-bounded (e.g., a small-utility-only feature) gets scored against the soul-aggregate design intent, which underweights the variant's specific design imperatives.

The framework needs an in-soul partition for this case that:

1. Inherits the soul's compliance + substrate (no escape hatch)
2. Allows a bounded specialization of design intent
3. Composes cleanly with admission scoring (variant-targeted work scores against variant intent, not soul-aggregate)

## 3. Goals

1. **First-class variant declaration on Soul DID** — `soul.spec.variants[]` with id, audience, design overrides
2. **Bounded inheritance** — variants inherit substrate + compliance from parent Soul; cannot escape either
3. **Admission scoring composes** — `targetedVariants` field on work items routes scoring through variant-level design intent (analogous to RFC-0009's `targetedSouls`)
4. **Boundary clarity** — explicit guidance for when to use a variant vs. spawn a separate Soul DID
5. **Backward compatibility** — Soul DIDs without variants behave identically to today
6. **Practitioner validation** — InternalAdopter's four-product suite proves out the pattern before normative status

## 4. Non-Goals

1. **Flow-based sub-divisions** — that's RFC-0018 (Journey). Variant is static configuration; Journey is temporal sequence.
2. **Cross-soul variants** — a variant lives within a single Soul DID. Cross-soul work uses RFC-0009's `targetedSouls`.
3. **Independent compliance regimes per variant** — variants inherit the soul's compliance floor with no escape hatch. If two configurations require different compliance regimes, they're separate Souls.
4. **Variant marketplaces** — third-party / customer-defined variants are explicitly out of scope; v1 limits variant declaration to the Soul DID author (Design Authority).
5. **Substrate divergence** — variants share the soul's `substrateInvariants` exactly. Substrate-level differences require a separate Soul.

## 5. Proposal

### 5.1 Variant declaration on Soul DID

Add `variants[]` to Soul DID `spec`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: SoulDID
metadata:
  name: spry-engage
spec:
  # ... existing Soul DID fields ...
  variants:
    - id: small-utility
      targetAudience:
        segments: [municipal-small, water-district-small]
        sizeRange: { minStaff: 1, maxStaff: 50 }
      designOverrides:
        voiceRegister: "approachable-municipal"
        colorPaletteOverlay: "small-utility-warm"
        densityProfile: "comfortable"
      complianceFloor: inherit  # MUST inherit; explicit for clarity
      designImperatives:
        - "low-tech-fluency-tolerance"
        - "single-task-focus-per-screen"
    - id: enterprise
      targetAudience:
        segments: [municipal-large, regional-utility]
        sizeRange: { minStaff: 51, maxStaff: 5000 }
      designOverrides:
        voiceRegister: "professional-administrative"
        colorPaletteOverlay: "enterprise-cool"
        densityProfile: "compact"
      complianceFloor: inherit
      designImperatives:
        - "bulk-operation-efficiency"
        - "multi-tab-workflow-tolerance"
```

### 5.2 Variant fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string (kebab-case, unique within soul) | yes | Variant identifier |
| `targetAudience` | object | yes | Audience characteristics; structure mirrors Soul DID `targetAudience` schema (Sα₁ input) |
| `designOverrides` | object | no | Subset of design fields the variant specializes (voice, color overlay, density). MUST be a subset of fields the parent Soul declares as variant-overridable. |
| `complianceFloor` | enum (`inherit`) | yes | MUST be `inherit`. Variants cannot diverge from soul compliance. The field is required-and-fixed for clarity at the YAML surface — schema validation rejects any other value. |
| `designImperatives` | string[] | no | Variant-scoped Sα₂ inputs. Layered on top of soul-level `designImperatives`; variant imperatives take precedence in conflict (most-specific-wins). |
| `cardinality` (RESERVED) | enum (`primary`, `secondary`, `experimental`) | no | Future-use lifecycle hint. v1 ignores; documents the `experimental` exit ramp for OQ-3. |

### 5.3 Bounded inheritance

A Variant inherits from its parent Soul DID:

| Inherited (variant cannot override) | Specializable (variant overrides allowed) |
|---|---|
| `complianceRegimes` (per-soul) | `voiceRegister` (variant-scoped) |
| `substrateInvariants` | `colorPaletteOverlay` (additive layer over soul palette) |
| `tenantQuotaShare` (RFC-0010) | `densityProfile` |
| `engineering.performanceBudgets` | `designImperatives` (additive, most-specific-wins) |
| `engineering.observabilityRequirements` | `targetAudience` (variant-specific segments) |

If a variant attempts to override an inherited field, schema validation MUST emit `VariantInheritanceViolation` (Engineering vertex error per RFC-0008 §C5).

### 5.4 Admission scoring composition

Work items target a variant via `targetedVariants` (parallel to RFC-0009 `targetedSouls`):

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: WorkItem
metadata:
  name: small-utility-onboarding-improvement
spec:
  targetedSouls: [spry-engage]
  targetedVariants: [spry-engage/small-utility]   # Soul-id/Variant-id
```

Scoring composes per-variant:

- **Sα₁ Audience Resonance** — variant's `targetAudience` overrides soul's
- **Sα₂ Vibe Coherence** — variant's `designImperatives` UNION soul's; conflict resolution: variant wins (most-specific)
- **Cκ Capability Coverage** — soul-level (variants don't override capability)
- **Eρ_n** — soul-level (variants inherit compliance/substrate; no override)
- **Dπ_n** — soul-level (Demand Pressure / Market Force / Entropy Tax are platform-aggregate channels)

Cross-variant scoring rule (work touches multiple variants of same soul) — same `min` aggregation as RFC-0009 §7.2 for cross-soul, applied at the variant scope. Per RFC-0009 OQ-2: `min` is the default; opt-in alternatives (`max`, `weighted`) require explicit declaration.

### 5.5 Boundary: variant vs. separate Soul

**Use a Variant when:**
- Same compliance regime (WCAG level, regulatory posture, retention rules)
- Same substrate (event bus, schema, tenant model)
- Different audience + visual specialization within the same product face

**Use a separate Soul when:**
- Different compliance regime (e.g., HIPAA vs. SOC2, different WCAG level)
- Different substrate (different event bus, different schema, different tenant model)
- Different "product face" (operator + adopter both perceive these as distinct products)

The Design Authority owns the boundary call. When uncertain, default to **separate Soul** — variants are an optimization for the homogeneous-substrate case; separate Souls are the safe default that preserves flexibility.

## 6. Design Details

### 6.1 Schema additions

Add to the Soul DID schema (file path: RFC-0009 implementation phase concern):

```json
{
  "properties": {
    "variants": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "targetAudience", "complianceFloor"],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]*$",
            "description": "Kebab-case variant identifier; unique within the soul."
          },
          "targetAudience": { "$ref": "#/$defs/AudienceProfile" },
          "designOverrides": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "voiceRegister": { "type": "string" },
              "colorPaletteOverlay": { "type": "string" },
              "densityProfile": { "type": "string", "enum": ["compact", "comfortable", "spacious"] }
            }
          },
          "complianceFloor": {
            "type": "string",
            "const": "inherit",
            "description": "MUST be 'inherit'. Variants cannot diverge from soul compliance."
          },
          "designImperatives": {
            "type": "array",
            "items": { "type": "string" }
          },
          "cardinality": {
            "type": "string",
            "enum": ["primary", "secondary", "experimental"]
          }
        }
      }
    }
  }
}
```

Add to the Work Item schema:

```json
{
  "properties": {
    "targetedVariants": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]*\\/[a-z][a-z0-9-]*$",
        "description": "Soul-id/variant-id format."
      }
    }
  }
}
```

### 6.2 Behavioral changes

- **Reconciliation** — when a variant is added/removed/modified, the `Eτ_tessellation_drift` detector (RFC-0009 §13) MUST scan substrate code for variant-specific identifiers (parallel to per-soul scan). Substrate code referring to specific variant IDs is a drift signal.
- **Admission scoring** — when `targetedVariants` is non-empty, the admission scorer routes Sα₁ + Sα₂ inputs through variant-level fields. When empty, scoring proceeds at soul scope (unchanged from RFC-0009 baseline).
- **Cross-soul work** — when a work item targets variants in MULTIPLE souls, the cross-soul aggregation rule (RFC-0009 §7.2) applies at the soul level FIRST, then the cross-variant rule applies within each soul.

### 6.3 Migration path

Soul DIDs without `variants[]` declared are unchanged. Adding variants is purely additive. Removing a variant requires:

1. Sweep `targetedVariants` across all open work items; reject removal if any work item references the variant
2. Provide deprecation window (default 30 days) before hard-removal
3. Emit `VariantRemoved` event per RFC-0008 event taxonomy

## 7. Backward Compatibility

**Not a breaking change.** Soul DIDs that don't declare `variants[]` continue to behave identically. Work items that don't declare `targetedVariants` are scored at soul scope as before.

The only soft regression: if a Soul DID's Sα₂ scoring previously relied on operator-implicit knowledge of audience-specific design intent, surfacing variants makes that intent explicit AND scorable. Some operators may discover their existing `designImperatives` are over-aggregated; the migration is to factor them into variant-specific lists.

## 8. Alternatives Considered

### 8.1 Subclasses (variant inherits Soul via `extends:`)

OO-style inheritance with method-override semantics. **Rejected** — too sharp an edge; operators end up reasoning about what's overridable. The bounded-inheritance table (§5.3) is more constrained and less surprising.

### 8.2 Composition (variant composes a Soul + an overlay resource)

Variants as separate `kind: SoulVariant` resources composed at admission time. **Rejected** — adds a resource kind for a sub-concern that's tightly bound to a parent. Composition makes sense across loosely-coupled concerns; variant ↔ soul is a tight binding.

### 8.3 Tags / labels (variant as a label dimension on work items)

Skip the schema change; route through label-based filtering. **Rejected** — doesn't compose with admission scoring; loses the inheritance contract; doesn't surface in the Tessellated Design Intent Document hierarchy.

### 8.4 Just spawn a separate Soul per variant

The "use the existing Soul DID model" answer. **Rejected for the homogeneous-substrate case** (per §5.5) — creates platform-level fragmentation when the substrate genuinely doesn't differ. **Recommended for the heterogeneous-substrate case** — RFC keeps the boundary explicit.

## 9. Implementation Plan

- [ ] Soul DID schema addition (`variants[]`)
- [ ] Work Item schema addition (`targetedVariants`)
- [ ] Admission scorer composition (Sα₁ + Sα₂ variant routing)
- [ ] Variant inheritance validator (`VariantInheritanceViolation` event)
- [ ] `Eτ_tessellation_drift` detector extension for variant-scoped scans
- [ ] InternalAdopter four-product suite as reference implementation (one variant per product, minimum)
- [ ] Glossary additions (`Variant`, `targetedVariants`, `complianceFloor: inherit`)
- [ ] Conformance test suite — variant declaration round-trip; admission-scoring composition; inheritance enforcement
- [ ] Author/update each user-facing doc surface declared in `requiresDocs` (currently `[]` — pending tutorial/runbook decision)

## 10. Open Questions — resolved (operator walkthrough 2026-05-18)

> **Resolution status (2026-05-18):** All 8 §10 OQs resolved via operator walkthrough with full rubric (problem → industry research → options → recommendation + counter-argument). Lifecycle promoted Draft → Ready for Review. **Cross-cutting framing:** operator-impacting variant-substrate events (count thresholds, deprecation transitions, Engineering substrate-cost review, cardinality activation requests) route through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md). §10.1 codifies per-Soul / per-org config. Implementation broken into 5 phase tasks: AISDLC-352..356.

**OQ-1 — Maximum variants per Soul:** Should the schema cap variant count (e.g., max 5) to discourage over-fragmentation, or trust operators? Recommendation: soft warning at 5+, hard limit at 20 (sanity check, not design constraint).

   **Resolution (2026-05-18):** **Per-org configurable; defaults 5 (soft warn) / 20 (hard limit).** Author's research-grounded defaults (5 ≈ Miller's 7±2 cognitive-load threshold; 20 ≈ re-architect-as-multi-soul threshold per RFC-0009 §3) wrapped in the per-org-configurability convention established across this session. Soft warn → `Decision: variant-count-soft-warning` (non-blocking batch review). Hard limit → refuse declaration + `Decision: variant-count-hard-limit-exceeded` + clarification task ("consider re-architecting as multi-soul"). **Selected over fixed 5/20** because adopters may surface tuning needs (e.g., marketplace with 30 vendor variants); marginal config surface vs. "file an RFC to bump the constant" friction.

**OQ-2 — Nested variants:** Can a variant declare its own sub-variants? Recommendation: NO for v1 — adds complexity for a use case (variant-of-variant) we have no practitioner evidence for. Revisit if InternalAdopter or another adopter surfaces a real need.

   **Resolution (2026-05-18):** **Schema-enforced flat: `variants[]` cannot contain `variants[]`** (design-tokens pattern: Tailwind / Material / Stripe / Vercel). Schema rejects nested declarations at validation. Future RFC lifts when ≥2 adopters surface concrete sub-variant use cases (mirrors OQ-8 cardinality threshold). **Selected over convention-only NO (author rec)** because schema-permissive + convention-gated is the design-token-explosion anti-pattern; schema enforcement keeps the design-authority loop intact.

**OQ-3 — Variant lifecycle (deprecation, removal):** §6.3 sketches the removal flow. What's the right deprecation-window default — 30 days, 90 days, or operator-configured per Soul? Recommendation: configurable per Soul with 30-day default.

   **Resolution (2026-05-18):** **Composite: 30d default + per-Soul `deprecationWindowDays` override + explicit G0-routed lifecycle states.** Lifecycle: (1) deprecation declared → `Decision: variant-deprecation-declared` (log; no interrupt); (2) approaching → `Decision: variant-deprecation-approaching` → operator batch surface; (3) at removal with consumers still referencing → `Decision: variant-removal-consumers-pending` → **auto-action:** keep variant in degraded mode + emit migration tasks. Pipeline never halts. 30d reflects internal-config cadence (vs RFC-0019's 90d for external providers). **Selected over fixed 30d** because per-Soul override accommodates slower migration cadences (large adopters needing 60-90d); selected over implicit-lifecycle because explicit specification prevents "we forgot to ship at-removal-degraded-mode" drift.

**OQ-4 — Cross-variant scoring rule precedence:** RFC-0009 §7.2 sets `min` as cross-soul default. Same default for cross-variant within a soul, OR should variants default to `max` (since they're more loosely coupled than souls within a tessellation)? Recommendation: same `min` default for consistency.

   **Resolution (2026-05-18):** **Per-Soul configurable, default `min`** (matches RFC-0009 §7.2 cross-soul). `min` matches RFC-0009 (consistency across tessellation hierarchy) AND matches industry safety-critical aggregation convention (compliance / security / performance all use `min`). Variants share substrate + compliance + foundational triad per §3.2 — they're MORE tightly coupled than tessellated souls, so safety-critical aggregation applies even more strongly. Per-Soul `crossVariantAggregation` config accommodates adopters with genuine reasons to override (e.g., experimental-variant promotion via `max`). **Selected over fixed `min`** because per-org-config has been the recurring pattern this session; consistency matters for adopter expectations.

**OQ-5 — designOverrides extensibility:** §6.1 lists `voiceRegister`, `colorPaletteOverlay`, `densityProfile`. Should this be open-ended (any field name) or closed-enum? Recommendation: closed-enum for v1 to force design-authority discipline; expand as new override needs surface.

   **Resolution (2026-05-18):** **Closed framework enum + vendor-prefix extension** (composes with RFC-0025 OQ-10 vendor-namespace pattern + Kubernetes CRD / JSON Schema / HTML `data-*` conventions). Framework owns `voiceRegister`, `colorPaletteOverlay`, `densityProfile` (closed; expanding requires RFC amendment with Design sign-off). Adopters extend via vendor reverse-DNS prefix (e.g., `acme.com/accessibilityProfile`); schema validates prefix. **Selected over closed-enum-only (author rec)** because vendor-prefix pattern is already established in this codebase (RFC-0025 OQ-10) and across the ecosystem; provides extension flexibility without compromising Design Authority's loop on framework-owned fields.

**OQ-6 — Variant ID URI representation in DID:** RFC-0009 uses `did:platform-x:soul:engage`. What's the variant URI? Options: (a) `did:platform-x:soul:engage/variant:small-utility`, (b) `did:platform-x:soul:engage:small-utility` (slug-concat), (c) `did:platform-x:variant:engage/small-utility`. Recommendation: (a) — preserves explicit hierarchy.

   **Resolution (2026-05-18):** **Option (a) — `did:platform-x:soul:engage/variant:small-utility`** (path-style with explicit `variant:` keyword) per author rec. Matches Kubernetes resource paths / HTTP REST / AWS ARN / DID Web conventions (hierarchical resource systems consistently use path-style with explicit kind keywords). Preserves the structural inheritance relationship (variant is a CHILD of soul per §3.2). Composes naturally with future nested-variant extension AND with future in-soul partition types from RFC-0018 (`/journey:onboarding-flow`). **Selected over slug-concat (b)** because (b) has parser ambiguity; **selected over option (c)** because (c) treats variant as peer of soul, contradicting the inheritance model.

**OQ-7 — Engineering authority on variant declarations:** RFC-0009 makes Design Authority the owner of `design.*` fields with Engineering as reviewer. Same model for variant declarations? Or does Engineering own `targetAudience` (since audience determines load characteristics)? Recommendation: Design owns variant declaration; Engineering reviews + may block on substrate-cost grounds.

   **Resolution (2026-05-18):** **Design owns + Engineering review routed through Decision Catalog.** Author's pillar-model split (Design owns; Engineering reviews) is architecturally correct per RFC-0029 Principle 1 + project_team_roles.md. Engineering's review becomes a tracked `Decision: variant-substrate-cost-review` in the catalog. Substrate-cost block → `Decision: variant-substrate-cost-block` → Design/Engineering routing per RFC-0029 actor model. **Selected over convention-only review-may-block** because convention-only is the same anti-pattern that produced AISDLC-269's "forgot to operator-walk-through" failure — explicit Decision-Catalog routing makes the review loop AUDITABLE.

**OQ-8 — `cardinality` field activation:** §5.2 reserves `cardinality: primary | secondary | experimental` for v2. What's the v1 → v2 trigger to activate this — practitioner demand, or a specific lifecycle event? Recommendation: defer activation to a follow-on RFC when at least 2 adopters request lifecycle distinctions.

   **Resolution (2026-05-18):** **Future Decision in catalog; auto-promote on ≥2 adopter requests.** Author's threshold expressed through the Decision Catalog substrate. Each adopter request → `Decision: variant-cardinality-activation-request` → Stage A counter; at threshold, Decision auto-promotes to operator batch review with "file follow-on RFC" recommendation. Composes with RFC-0036 OQ-6 first-party-adapter graduation pattern (identical shape). **Selected over convention-only** because "we'll notice when adopters ask" relies on operator manually catching the signal — same anti-pattern surfaced elsewhere this session.

### 10.1 Configuration Schema (per-Soul / per-org defaults)

Per-organization configurability across the OQ resolutions. Per-Soul overrides codify variant-substrate config:

```yaml
# .ai-sdlc/variant-config.yaml (per-org defaults)
variant:
  limits:                                    # OQ-1
    softWarnAt: 5                            # Miller's 7±2 cognitive-load threshold
    hardLimit: 20                            # re-architect-as-multi-soul threshold per RFC-0009 §3

  lifecycle:                                 # OQ-3
    deprecationWindowDays: 30                # internal-config cadence default
    routing:
      onDeclared: log-catalog-no-interrupt
      onApproaching: operator-batch-surface
      onConsumersPending: degraded-mode-and-migration-tasks

  scoring:                                   # OQ-4
    crossVariantAggregation: min             # matches RFC-0009 cross-soul default

  overrides:                                 # OQ-5
    framework:
      - voiceRegister
      - colorPaletteOverlay
      - densityProfile
    adopterExtensionsAllowed: true           # via vendor reverse-DNS prefix

  uri:                                       # OQ-6
    format: 'did:{method}:{platform}:soul:{soul-id}/variant:{variant-id}'

  authority:                                 # OQ-7
    declarationOwner: design
    substrateCostReview:
      reviewer: engineering
      routing: decision-catalog
      blockDecision: variant-substrate-cost-block

  cardinality:                               # OQ-8
    activationThreshold:
      adopterRequests: 2
    routing: decision-catalog-auto-promote
```

Default constants ship in the `ai-sdlc init` variant-config template. Per-Soul overrides via the soul's `spec.variantConfig` block (composes with RFC-0009 substrate). Schema enforces limits at variant-declaration load, lifecycle states at deprecation transitions, vendor-prefix for adopter override fields.

## 11. Practitioner Validation Plan

InternalAdopter's four-product suite drives the validation pass:

| Soul | Variants (proposed) | Validates |
|---|---|---|
| ProductA | small-utility, enterprise, county-regional | Audience-segment specialization; voice register variation |
| ProductB | field-tech-on-truck, field-tech-handheld, supervisor-tablet | Density profile + form-factor specialization |
| ProductC | billing-clerk, customer-portal, csr-dashboard | Role-based audience + workflow-density specialization |
| ProductD | annual-test, repair-event, regulatory-audit-mode | Temporal-context-bound design intent (validates the §11 carries through to RFC-0018 Journey too) |

Validation criteria (Mo's edits welcome):
1. Each variant's design intent is articulable in ≤ 5 `designImperatives` strings
2. No variant requires a field NOT in the §6.1 schema (closed-enum holds)
3. Admission scoring on a real work item (e.g., "small-utility onboarding improvement") produces a different + better-justified score than soul-aggregate scoring
4. Engineering vertex confirms substrate is genuinely shared across all variants of each soul (no hidden divergence)

## 12. References

- [RFC-0009 Tessellated Design Intent Documents](RFC-0009-tessellated-design-intent-documents.md) — parent Soul DID model
- [RFC-0008 PPA Triad Integration](RFC-0008-ppa-triad-integration-final-combined.md) — admission scoring foundation; variant scoring extends `targetedSouls` pattern
- [RFC-0018 In-Soul Journey Pattern](RFC-0018-in-soul-journey-pattern.md) — companion: temporal flow patterns within a Soul or Variant

## 13. Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-04 | Morgan Hirtle | Initial stub (carve-out from RFC-0009 OQ-3). Established summary + practitioner-validation source. |
| v0.2 | 2026-05-04 | Engineering pass (Dominique + Claude Opus 4.7) | Filled §3-§13 from boilerplate. Schema sketch, inheritance table, admission-scoring composition, boundary-vs-separate-soul, alternatives, 8 open questions, InternalAdopter validation plan. Awaiting Mo's design-authority editorial pass on §5.3 + §10. |
| v0.3 | 2026-05-18 | Dominique (Operator OQ walkthrough) | Full-rubric resolution of all 8 §10 OQs (problem → industry research → 3-4 options → recommendation + counter-argument per OQ). Resolutions: per-org configurable variant count limits (OQ-1, defaults 5 soft / 20 hard); schema-enforced flat (no nested variants for v1 — OQ-2); composite deprecation lifecycle with 30d default + per-Soul override + G0-routed degraded-mode (OQ-3); per-Soul configurable cross-variant aggregation with `min` default (OQ-4, matches RFC-0009); closed framework enum + vendor-prefix extension for designOverrides (OQ-5, composes with RFC-0025 OQ-10 pattern); path-style URI `did:.../variant:...` (OQ-6); Design owns + Engineering review via Decision Catalog (OQ-7); cardinality activation via catalog auto-promote on ≥2 adopter requests (OQ-8). §10.1 added consolidating per-Soul / per-org `.ai-sdlc/variant-config.yaml` schema. Cross-cutting framing: all operator-impacting variant lifecycle events route through RFC-0035 G0 non-blocking pipeline contract. Frontmatter requires expanded: added RFC-0024 (capture substrate), RFC-0025 (audit), RFC-0029 (pillar model), RFC-0035 (catalog routing). Lifecycle promoted Draft → Ready for Review. Implementation broken into 5 phase tasks: AISDLC-352 (Phase 1 schema additions), AISDLC-353 (Phase 2 admission scorer composition), AISDLC-354 (Phase 3 Eτ_tessellation_drift extension + deprecation lifecycle), AISDLC-355 (Phase 4 InternalAdopter four-product reference impl), AISDLC-356 (Phase 5 glossary + conformance test suite + doc surfaces). Practitioner-validation gates in §11 remain unresolved pending InternalAdopter implementation pass. |
