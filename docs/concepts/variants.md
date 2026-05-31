# Soul Variants

**Document type:** Informative
**RFC:** [RFC-0017 — In-Soul Variant Pattern](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md)
**Status:** Signed Off

---

## What is a Variant?

A **Variant** is a named sub-theme within a Soul DID. It carries its own visual identity specializations and audience targeting while sharing the parent Soul's foundational triad (E × P × D), substrate, and compliance regime.

Think of Variants as flavors of the same product face — not different products.

### Concrete example

InternalAdopter's **spry-engage** soul targets municipal government. Within that soul, three distinct audience segments exist:

| Variant | Audience | Visual specialization |
|---|---|---|
| `small-utility` | Water districts, small municipalities (1–50 staff) | Large print, comfortable density, warm palette |
| `enterprise` | Large municipalities, regional utilities (51–5000 staff) | Compact density, cool palette, full motion |
| `county-regional` | County government, regional coordinators (20–200 staff) | Sharp corners, regional brand tokens |

All three variants share the same WCAG 2.1 AA compliance floor, the same event bus, and the same design system foundation. Only the visual specialization and audience targeting differ.

---

## When to use a Variant vs. a separate Soul

| Use a Variant | Use a separate Soul |
|---|---|
| Same compliance regime (WCAG level, regulatory posture, retention rules) | Different compliance regime (e.g. HIPAA vs. SOC2, different WCAG level) |
| Same substrate (event bus, schema, tenant model) | Different substrate (different event bus, schema, or tenant model) |
| Same product face — operator and adopter perceive it as one product | Different "product face" — both operator and adopter perceive these as distinct products |

**When uncertain, default to a separate Soul.** Variants are an optimization for the homogeneous-substrate case. Separate Souls are the safe default that preserves flexibility. The Design Authority owns this boundary call.

---

## Bounded inheritance

A Variant inherits from its parent Soul and **cannot escape** the inheritance contract:

| Inherited (variant cannot override) | Specializable (variant can override) |
|---|---|
| `complianceRegimes` | `colorPaletteOverlay` |
| `substrateInvariants` | `densityProfile` (`compact`, `comfortable`, `spacious`) |
| `tenantQuotaShare` | `typographyScale` (`default`, `large-print`, `data-dense`) |
| `engineering.performanceBudgets` | `motionProfile` (`full`, `reduced`, `none`) |
| `engineering.observabilityRequirements` | `radiusProfile` (`sharp`, `default`, `rounded`) |
| | `designImperatives` (additive; variant wins on same dimension) |
| | `targetAudience` (variant-specific segments) |

The `complianceFloor: inherit` field is **required on every variant** and schema validation rejects any other value. This is the core invariant — if two configurations need different compliance regimes, they are separate Souls.

### Vendor-prefix extensions

Framework-owned `designOverrides` fields are a closed enum (see table above). Adopters extend via vendor reverse-DNS prefix:

```yaml
designOverrides:
  colorPaletteOverlay: "small-utility-warm"
  acme.com/accessibilityProfile: "wcag-aa-plus"
  acme.com/animationBudget: "100ms"
```

Schema validates the prefix format but not the value. Vendor-prefix extensions compose with the RFC-0025 OQ-10 pattern.

---

## Admission scoring composition

When a work item declares `targetedVariants`, admission scoring routes through the variant's fields:

| Score | Source |
|---|---|
| Sα₁ Audience Resonance | Variant's `targetAudience` overrides soul's |
| Sα₂ Vibe Coherence | Variant's `designImperatives` UNION soul's (variant wins on same dimension) |
| Cκ Capability Coverage | Soul-level (variants don't override capability) |
| Eρ_n Compliance | Soul-level (variants inherit compliance/substrate; no override) |
| Dπ_n Demand Pressure | Soul-level (platform-aggregate channels) |

For work items targeting multiple variants of the same soul, scores are aggregated using the `crossVariantAggregation` rule (default `min`, same as RFC-0009 §7.2 cross-soul). Per-Soul configuration can override to `max` or `mean`.

---

## Cardinality field (RESERVED — v2)

The `cardinality` field (`primary | secondary | experimental`) is reserved in the schema and **ignored at runtime in v1**. It documents the planned exit ramp for variants that need lifecycle distinctions.

Activation is gated by the OQ-8 Decision Catalog mechanism: when at least 2 distinct adopters request cardinality activation, the Decision auto-promotes to operator batch review with a "file follow-on RFC" recommendation. See [variant-pattern-promotion.md](../operations/variant-pattern-promotion.md) §Cardinality Activation.

---

## Related resources

- [RFC-0017 In-Soul Variant Pattern](../../spec/rfcs/RFC-0017-in-soul-variant-pattern.md) — normative spec
- [Declaring Variants tutorial](../tutorials/12-declaring-variants.md) — step-by-step walkthrough
- [Variant Deprecation Runbook](../operations/variant-deprecation.md) — lifecycle management
- [Variant Pattern Promotion Runbook](../operations/variant-pattern-promotion.md) — operator-driven default-on flip
- [RFC-0009 Soul DID model](../../spec/rfcs/RFC-0009-tessellated-design-intent-documents.md) — parent model
